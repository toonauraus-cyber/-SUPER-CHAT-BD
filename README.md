# SUPER CHAT BD

A fresh Node.js + Express + PostgreSQL creator-support platform with creator pages, donation links, QR codes, manual donation review, live verified-donation alerts, creator withdrawal requests, and an admin dashboard.

## Included

- Creator sign-up/sign-in and persistent server-side sessions
- Custom public creator page: display name, bio, avatar URL, logo URL, banner URL and theme color
- Unique shareable creator link and QR code
- Donation amount, donor name, message and anonymous option
- Admin-configurable collection methods (bKash, Nagad, Rocket, Upay are seeded but disabled until configured)
- Admin verifies or rejects donations
- A verified donation immediately emits a Socket.IO event to the creator's open dashboard
- Creator withdrawal requests
- Withdrawal methods seeded: bKash, Nagad, Rocket, Upay, Tap and Pubali Bank
- Admin controls withdrawal method availability, min/max limits and fee settings
- Admin can suspend/activate creators and review withdrawals
- Idempotent database initialization: tables and indexes are created safely on startup

## Important payment note

This initial release uses **manual transaction-reference submission and admin verification**. It does not pretend that a payment is automatically verified. A real gateway such as Zinipay must be integrated later using the provider's official API, credentials, callback/webhook signature verification and idempotency rules. Never collect a customer's mobile banking PIN or OTP in this website. A legitimate payment provider handles those securely in its own app/USSD flow.

## Deploy to Render

1. Create a new GitHub repository and upload the project files while preserving the `public` folder.
2. In Render, choose **New + → Blueprint** and connect that repository. Render reads `render.yaml` and creates the web service and PostgreSQL database.
3. In the service Environment, set:
   - `ADMIN_EMAIL` = the email you want to use for the platform administrator
   - `ADMIN_PASSWORD` = a strong password of at least 12 characters
   - `BASE_URL` = your final `https://...onrender.com` URL
4. Deploy. The server creates the database tables and default method rows automatically.
5. Open `https://your-service.onrender.com/api/health`. Expected response: `{"ok":true,"service":"SUPER CHAT BD","database":"connected"}`.
6. Open the main URL and sign in with the admin email/password configured above.

## If creating a Web Service manually

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Add a Render PostgreSQL database and set `DATABASE_URL` to its **Internal Database URL**.
- Add `SESSION_SECRET` (random, long, at least 24 characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `BASE_URL`.

Do not set `DATABASE_URL` to `localhost` on Render. Do not paste database passwords into public source files or GitHub.

## Local development

1. Install Node.js 20+ and PostgreSQL.
2. Copy `.env.example` to `.env` and set a real local `DATABASE_URL` and a long `SESSION_SECRET`.
3. Run `npm install`, then `npm start`.
4. Visit `http://localhost:3000`.

`.env` values are loaded locally through `dotenv`. Render environment variables are read directly from the service environment.

## Current scope and production checklist

- This project is a clean starting implementation, not a guarantee of zero deployment issues in every hosting account.
- Upload fields accept hosted image URLs. Add authenticated file storage (for example, S3/Cloudinary) before accepting arbitrary image uploads.
- Payment gateway verification is intentionally not activated yet.
- Before public launch, configure real payment accounts, privacy/terms/refund pages, rate limits/WAF, database backups, email verification/password reset, and review all financial workflows.
- Use HTTPS only in production.
