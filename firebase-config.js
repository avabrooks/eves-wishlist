// Firebase web app settings for Eve's Wishlist.
// These values are not secrets. Access is limited by the rules in firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyCkYoFZt8x9_wqN4_h0aeYMOCcgA8ed6-w",
  authDomain: "eves-wishlist.firebaseapp.com",
  projectId: "eves-wishlist",
  storageBucket: "eves-wishlist.firebasestorage.app",
  messagingSenderId: "934296360042",
  appId: "1:934296360042:web:d9a9f6f381b05ac6eba613"
};

// Link reader (Cloudflare Worker). Paste its address here so pasting a product link fills in the details.
// Leave it empty to turn auto-fill off.
export const extractorUrl = "https://wishlist-fetch.avacbrooks.workers.dev";
