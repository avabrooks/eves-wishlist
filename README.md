# Eve's Wishlist

A ranked wishlist with photos, prices, store links, drag-and-drop priority and a payday timeline
that shows which paycheck each thing becomes affordable.

It is a plain website (no build step). Her list is stored in her own Firebase project (free), not in
this repo, and only the Google accounts you allow can open it.

Until you finish the setup below, the site still works in "this device only" mode so you can try it.

## Setup (about 20 minutes, one time)

### 1. Create the free Firebase project (holds the list)

1. Go to https://console.firebase.google.com and sign in with your Google account.
2. **Create a project**, name it `eves-wishlist`, and turn Google Analytics off.
3. In the left menu open **Build > Firestore Database > Create database**. Pick a location near you
   and choose **Start in production mode**.
4. Open the **Rules** tab, replace everything with the contents of `firestore.rules` from this repo,
   change the two email addresses to Eve's Google account and yours, then click **Publish**.
   This is what keeps everyone else out.
5. Open **Build > Authentication > Get started > Sign-in method > Google**, switch it on, choose a
   support email, and **Save**.
6. Still in Authentication, open **Settings > Authorized domains** and add the address the site will
   live on (step 3 below): `YOURNAME.github.io`, plus your own domain if you buy one.

You stay on the free "Spark" plan. No credit card is needed for any of this.

### 2. Connect the site to Firebase

1. In Firebase, click the gear icon > **Project settings**. Under **Your apps**, click the web icon `</>`,
   give it any nickname, and register it (skip Firebase Hosting).
2. Copy the `firebaseConfig` values it shows.
3. Open `firebase-config.js` in this repo and paste them over the `PASTE_...` placeholders.

### 3. Put the site online with GitHub Pages

1. On GitHub, create a new **public** repository (for example `eves-wishlist`) and upload all the files
   from this folder (drag them into the "uploading an existing file" page).
2. In the repo go to **Settings > Pages**. Under **Build and deploy** choose **Deploy from a branch**,
   branch `main`, folder `/ (root)`, then Save.
3. After a minute the site is live at `https://YOURNAME.github.io/eves-wishlist/`.
   Add `YOURNAME.github.io` to Firebase's authorized domains (step 1.6) if you haven't yet.

The repo has to be public for free Pages hosting. That is fine: it only holds the page's code. Her items,
photos and paycheck numbers live in Firebase, and a stranger who opens the link only sees a sign-in screen.

### 4. Optional: use your own web address

Instead of `YOURNAME.github.io/eves-wishlist`, you can use something like `eveswishlist.com`.

1. Buy the domain from any registrar (Cloudflare, Namecheap, Porkbun and others).
2. In the registrar's DNS settings add four `A` records for the bare domain pointing to
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`, and a `CNAME` record
   for `www` pointing to `YOURNAME.github.io`.
3. In the repo, **Settings > Pages > Custom domain**, enter the domain and Save. Once it verifies
   (can take up to a day), tick **Enforce HTTPS**.
4. Add the new domain to Firebase **Authentication > Settings > Authorized domains**.

### 5. Put it on her phone and laptop

Open the site, sign in with Google, and:

- **iPhone:** Share button > **Add to Home Screen**.
- **Laptop:** just bookmark it.

Her list syncs between devices, and it keeps working briefly without a connection.

## Auto-fill from a product link (optional)

Pasting a product link into "Add something" fills in the name, price, color and photo when the shop publishes
them. This uses a tiny free helper (`worker.js`) running on Cloudflare Workers.

1. Create a free Cloudflare account (no card needed), then **Workers & Pages > Create > Create Worker**.
2. Name it `wishlist-fetch` and **Deploy**, then **Edit code**, replace everything with the contents of `worker.js`, and **Deploy**.
3. Copy the worker's address (it ends in `.workers.dev`) into `extractorUrl` in `firebase-config.js`.
4. If you later use your own domain, add it to `ALLOWED_ORIGINS` at the top of `worker.js`.

Some shops (Zara, Amazon and other big retailers) block automated readers. For those there is the **Add button**
(`add-button.html`): a bookmark she taps while looking at the item in her own browser. It reads the name, price and photo
from the page she can already see, so it works on any shop, then opens the wishlist with the form filled in.
Size can't be read from a page, so she picks that herself.

## Share from her phone (optional, recommended)

`iphone-share.html` (linked from the wishlist's "phone Share button" hint) walks through it:

- **iPhone:** two Shortcuts. One works from any app's Share menu and opens the wishlist with the link loaded. The other,
  for shops that block automatic lookups, runs the page reader inside Safari on the page she is looking at.

When a lookup can't find the price or photo, the item can still be saved. It gets an "Add price & photo" tag that she can tap
later to try again or type them in.

## Optional: let the helper open pages in a real browser

Some shops only show their price and photo to a real browser. Cloudflare offers a real-browser service on your account.
To switch it on, create an API token in Cloudflare (My Profile > API Tokens > Create Token, with the permission
**Account > Browser Rendering > Edit**), then in your worker open **Settings > Variables and Secrets** and add two secrets:
`CF_ACCOUNT_ID` (your account ID, shown on the Workers overview page) and `CF_API_TOKEN` (the token).
The worker only uses it when a normal lookup comes back without a price or photo. Visiting the worker's address shows
`"browser": true` once it is on. Shops that block Cloudflare too will still fall back to saving the link.

## Advanced: phone downloads the page, helper reads it

`POST /go` on the helper takes `{"url": "...", "html": "..."}` (a page the phone downloaded itself) and answers with a wishlist
link that opens the form filled in. A Shortcut can chain "Get Contents of URL" (the product page), then "Get Contents of URL"
(POST to `/go`, JSON with `url` and `html`), then "Open URLs". `POST /parse` returns the details as JSON instead.

## Files

- `index.html` is the whole app.
- `add-button.html` is the setup page for the Add button (bookmark).
- `iphone-share.html` is the setup page for the Share menu (iPhone Shortcuts).
- `firebase-config.js` is where the Firebase settings go.
- `worker.js` is the helper that reads product links (runs on Cloudflare, not on GitHub).
- `firestore.rules` is the security rule to paste into Firebase (not used by the site itself).
- `manifest.webmanifest` and the `.png` files make it installable on a phone.

## Changing who has access

Edit the email list in Firebase **Firestore Database > Rules** and Publish.
