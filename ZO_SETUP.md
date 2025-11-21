# Zoho Mail Integration Setup for Local Development

It seems like the Zoho Mail connection is failing because the Edge Function is not reachable or the database schema is missing. Please follow these steps to fix it.

## 1. Apply Database Migrations

The table `zoho_oauth_tokens` is required. Run this command in your terminal:

```powershell
npx supabase migration up
```

If this command fails or you are not using the local CLI this way, make sure the SQL in `supabase/migrations/20250122000000_create_zoho_oauth_tokens.sql` is applied to your database.

## 2. Configure Environment Variables

Ensure your `.env` file contains the following (replace with your actual Zoho credentials if different):

```env
ZOHO_CLIENT_ID=1000.6YSK4H9LU3HR06HKN65L6YBYCRGGTI
ZOHO_CLIENT_SECRET=YOUR_ZOHO_CLIENT_SECRET
```

**Crucial:** The `ZOHO_CLIENT_ID` used in the frontend (defaults to the one above) MUST match the one used by the backend.

## 3. Serve Edge Functions

For the Edge Function to work locally, it must be running. Open a new terminal window and run:

```powershell
npx supabase functions serve --env-file .env
```

This will start the functions server (usually at `http://127.0.0.1:54321/functions/v1/`).

## 4. Verify Supabase URL

Your `src/components/atomic-crm/contacts/ZohoMailCallback.tsx` tries to connect to:
`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zoho-oauth-callback`

Ensure `VITE_SUPABASE_URL` in your `.env` or `.env.local` points to your local Supabase instance (usually `http://127.0.0.1:54321`).

## 5. Test Again

1. Go to the contact page.
2. Click "Connect Zoho Mail".
3. Login to Zoho.
4. When redirected back, the page will now show detailed logs on the screen.
   - If it says "Backend error", check the terminal where `supabase functions serve` is running.
   - If it hangs at "Connecting...", check the browser console (F12) for network errors.

