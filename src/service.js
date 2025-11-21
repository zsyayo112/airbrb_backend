import { Redis } from '@upstash/redis';
import jwt from 'jsonwebtoken';
import AsyncLock from 'async-lock';
import fs from 'fs';
import { InputError, AccessError } from './error.js';

const lock = new AsyncLock();

const JWT_SECRET = 'giraffegiraffebeetroot';

// Check if Redis credentials are available
const hasRedisCredentials = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

// Initialize Upstash Redis only if credentials are available
const redis = hasRedisCredentials ? new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
}) : null;

/***************************************************************
                       State Management
***************************************************************/

let users = {};
let listings = {};
let bookings = {};

const DATABASE_FILE = './database.json';

// Load data from Redis or local file
const loadData = async () => {
  if (hasRedisCredentials && redis) {
    try {
      const data = await redis.get('airbrb_data');
      if (data) {
        users = data.users || {};
        listings = data.listings || {};
        bookings = data.bookings || {};
        console.log('Data loaded from Redis');
        return;
      }
    } catch (error) {
      console.log('Error loading data from Redis:', error);
    }
  }

  // Fall back to local file storage
  try {
    const data = fs.readFileSync(DATABASE_FILE);
    const parsedData = JSON.parse(data);
    users = parsedData.users || {};
    listings = parsedData.listings || {};
    bookings = parsedData.bookings || {};
    console.log('Data loaded from local file');
  } catch (error) {
    console.log('No existing database file, starting fresh');
  }
};

// Initialize data
loadData();

const update = (users, listings, bookings) =>
  new Promise((resolve, reject) => {
    lock.acquire('saveData', async () => {
      try {
        // Try Redis first if available
        if (hasRedisCredentials && redis) {
          await redis.set('airbrb_data', {
            users,
            listings,
            bookings,
          });
          console.log('Data saved to Redis');
        } else {
          // Fall back to local file storage
          const dataToSave = JSON.stringify({ users, listings, bookings }, null, 2);
          fs.writeFileSync(DATABASE_FILE, dataToSave);
          console.log('Data saved to local file');
        }
        resolve();
      } catch (error) {
        console.error('Error saving data:', error);
        // Try local file as fallback
        try {
          const dataToSave = JSON.stringify({ users, listings, bookings }, null, 2);
          fs.writeFileSync(DATABASE_FILE, dataToSave);
          console.log('Data saved to local file (fallback)');
          resolve();
        } catch (fileError) {
          reject(new Error('Writing to storage failed'));
        }
      }
    });
  });

export const save = () => update(users, listings, bookings);
export const reset = async () => {
  await update({}, {}, {});
  users = {};
  listings = {};
  bookings = {};
};

/***************************************************************
                       Helper Functions
***************************************************************/

const newListingId = (_) => generateId(Object.keys(listings));
const newBookingId = (_) => generateId(Object.keys(bookings));

export const resourceLock = (callback) =>
  new Promise((resolve, reject) => {
    lock.acquire('resourceLock', callback(resolve, reject));
  });

const randNum = (max) => Math.round(Math.random() * (max - Math.floor(max / 10)) + Math.floor(max / 10));
const generateId = (currentList, max = 999999999) => {
  let R = randNum(max);
  while (currentList.includes(R)) {
    R = randNum(max);
  }
  return R.toString();
};

/***************************************************************
                       Auth Functions
***************************************************************/

export const getEmailFromAuthorization = (authorization) => {
  try {
    const token = authorization.replace('Bearer ', '');
    const { email } = jwt.verify(token, JWT_SECRET);
    if (!(email in users)) {
      throw new AccessError('Invalid Token');
    }
    return email;
  } catch {
    throw new AccessError('Invalid Token');
  }
};

export const login = (email, password) =>
  resourceLock((resolve, reject) => {
    if (!email) {
      return reject(new InputError('Must provide an email for user login'));
    } else if (!password) {
      return reject(new InputError('Must provide a password for user login'));
    } else if (email && email in users) {
      if (users[email].password === password) {
        users[email].sessionActive = true;
        resolve(jwt.sign({ email }, JWT_SECRET, { algorithm: 'HS256' }));
      }
    }
    return reject(new InputError('Invalid email or password'));
  });

export const logout = (email) =>
  resourceLock((resolve, reject) => {
    users[email].sessionActive = false;
    resolve();
  });

export const register = (email, password, name) =>
  resourceLock((resolve, reject) => {
    if (!email) {
      return reject(new InputError('Must provide an email for user registration'));
    } else if (!password) {
      return reject(new InputError('Must provide a password for user registration'));
    } else if (!name) {
      return reject(new InputError('Must provide a name for user registration'));
    } else if (email && email in users) {
      return reject(new InputError('Email address already registered'));
    } else {
      users[email] = {
        name,
        password,
        sessionActive: true,
      };
      const token = jwt.sign({ email }, JWT_SECRET, { algorithm: 'HS256' });
      resolve(token);
    }
  });

/***************************************************************
                       Listing Functions
***************************************************************/

const newListingPayload = (title, owner, address, price, thumbnail, metadata) => ({
  title,
  owner,
  address,
  price,
  thumbnail,
  metadata,
  reviews: [],
  availability: [],
  published: false,
  postedOn: null,
});

export const assertOwnsListing = (email, listingId) =>
  resourceLock((resolve, reject) => {
    if (!(listingId in listings)) {
      return reject(new InputError('Invalid listing ID'));
    } else if (listings[listingId].owner !== email) {
      return reject(new InputError('User does not own this Listing'));
    } else {
      resolve();
    }
  });

export const assertOwnsBooking = (email, bookingId) =>
  resourceLock((resolve, reject) => {
    if (!(bookingId in bookings)) {
      return reject(new InputError('Invalid booking ID'));
    } else if (bookings[bookingId].owner !== email) {
      return reject(new InputError('User does not own this booking'));
    } else {
      resolve();
    }
  });

export const addListing = (title, email, address, price, thumbnail, metadata) =>
  resourceLock((resolve, reject) => {
    if (title === undefined) {
      return reject(new InputError('Must provide a title for new listing'));
    } else if (Object.keys(listings).find((key) => listings[key].title === title) !== undefined) {
      return reject(new InputError('A listing with this title already exists'));
    } else if (address === undefined) {
      return reject(new InputError('Must provide an address for new listing'));
    } else if (price === undefined || isNaN(price)) {
      return reject(new InputError('Must provide a valid price for new listing'));
    } else if (thumbnail === undefined) {
      return reject(new InputError('Must provide a thumbnail for new listing'));
    } else if (metadata === undefined) {
      return reject(new InputError('Must provide property details for this listing'));
    } else {
      const id = newListingId();
      listings[id] = newListingPayload(title, email, address, price, thumbnail, metadata);

      resolve(id);
    }
  });

export const getListingDetails = (listingId) =>
  resourceLock((resolve, reject) => {
    resolve({
      ...listings[listingId],
    });
  });

export const getAllListings = () =>
  resourceLock((resolve, reject) => {
    resolve(
      Object.keys(listings).map((key) => ({
        id: parseInt(key, 10),
        title: listings[key].title,
        owner: listings[key].owner,
        address: listings[key].address,
        thumbnail: listings[key].thumbnail,
        price: listings[key].price,
        reviews: listings[key].reviews,
      })),
    );
  });

export const updateListing = (listingId, title, address, thumbnail, price, metadata) =>
  resourceLock((resolve, reject) => {
    if (address) {
      listings[listingId].address = address;
    }
    if (title) {
      listings[listingId].title = title;
    }
    if (thumbnail) {
      listings[listingId].thumbnail = thumbnail;
    }
    if (price) {
      listings[listingId].price = price;
    }
    if (metadata) {
      listings[listingId].metadata = metadata;
    }
    resolve();
  });

export const removeListing = (listingId) =>
  resourceLock((resolve, reject) => {
    delete listings[listingId];
    resolve();
  });

export const publishListing = (listingId, availability) =>
  resourceLock((resolve, reject) => {
    if (availability === undefined) {
      return reject(new InputError('Must provide listing availability'));
    } else if (listings[listingId].published === true) {
      return reject(new InputError('This listing is already published'));
    } else {
      listings[listingId].availability = availability;
      listings[listingId].published = true;
      listings[listingId].postedOn = new Date().toISOString();
      resolve();
    }
  });

export const unpublishListing = (listingId) =>
  resourceLock((resolve, reject) => {
    if (listings[listingId].published === false) {
      return reject(new InputError('This listing is already unpublished'));
    } else {
      listings[listingId].availability = [];
      listings[listingId].published = false;
      listings[listingId].postedOn = null;
      resolve();
    }
  });

export const leaveListingReview = (email, listingId, bookingId, review) =>
  resourceLock((resolve, reject) => {
    if (!(bookingId in bookings)) {
      return reject(new InputError('Invalid booking ID'));
    } else if (!(listingId in listings)) {
      return reject(new InputError('Invalid listing ID'));
    } else if (bookings[bookingId].owner !== email) {
      return reject(new InputError('User has not stayed at this listing'));
    } else if (bookings[bookingId].listingId !== listingId) {
      return reject(new InputError('This booking is not associated with this listing ID'));
    } else if (review === undefined) {
      return reject(new InputError('Must provide review contents'));
    } else {
      listings[listingId].reviews.push(review);
      resolve();
    }
  });

/***************************************************************
                       Booking Functions
***************************************************************/

const newBookingPayload = (owner, dateRange, totalPrice, listingId) => ({
  owner,
  dateRange,
  totalPrice,
  listingId,
  status: 'pending',
});

export const makeNewBooking = (owner, dateRange, totalPrice, listingId) =>
  resourceLock((resolve, reject) => {
    if (!(listingId in listings)) {
      return reject(new InputError('Invalid listing ID'));
    } else if (dateRange === undefined) {
      return reject(new InputError('Must provide a valid date range for the booking'));
    } else if (totalPrice === undefined || totalPrice < 0 || isNaN(totalPrice)) {
      return reject(new InputError('Must provide a valid total price for this booking'));
    } else if (listings[listingId].owner === owner) {
      return reject(new InputError('Cannot make bookings for your own listings'));
    } else if (listings[listingId].published === false) {
      return reject(new InputError('Cannot make a booking for an unpublished listing'));
    } else {
      const id = newBookingId();
      bookings[id] = newBookingPayload(owner, dateRange, totalPrice, listingId);

      resolve(id);
    }
  });

export const getAllBookings = () =>
  resourceLock((resolve, reject) => {
    resolve(
      Object.keys(bookings).map((key) => ({
        id: parseInt(key, 10),
        owner: bookings[key].owner,
        dateRange: bookings[key].dateRange,
        totalPrice: bookings[key].totalPrice,
        listingId: bookings[key].listingId,
        status: bookings[key].status,
      })),
    );
  });

export const removeBooking = (bookingId) =>
  resourceLock((resolve, reject) => {
    delete bookings[bookingId];
    resolve();
  });

export const acceptBooking = (owner, bookingId) =>
  resourceLock((resolve, reject) => {
    if (!(bookingId in bookings)) {
      return reject(new InputError('Invalid booking ID'));
    } else if (
      Object.keys(listings).find((key) => key === bookings[bookingId].listingId && listings[key].owner === owner) ===
      undefined
    ) {
      return reject(new InputError("Cannot accept bookings for a listing that isn't yours"));
    } else if (bookings[bookingId].status === 'accepted') {
      return reject(new InputError('Booking has already been accepted'));
    } else if (bookings[bookingId].status === 'declined') {
      return reject(new InputError('Booking has already been declined'));
    } else {
      bookings[bookingId].status = 'accepted';
      resolve();
    }
  });

export const declineBooking = (owner, bookingId) =>
  resourceLock((resolve, reject) => {
    if (!(bookingId in bookings)) {
      return reject(new InputError('Invalid booking ID'));
    } else if (
      Object.keys(listings).find((key) => key === bookings[bookingId].listingId && listings[key].owner === owner) ===
      undefined
    ) {
      return reject(new InputError("Cannot accept bookings for a listing that isn't yours"));
    } else if (bookings[bookingId].status === 'declined') {
      return reject(new InputError('Booking has already been declined'));
    } else if (bookings[bookingId].status === 'accepted') {
      return reject(new InputError('Booking has already been accepted'));
    } else {
      bookings[bookingId].status = 'declined';
      resolve();
    }
  });