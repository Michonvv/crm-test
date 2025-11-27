# Zoho Mail Integration: Remote Deployment Guide

Since you are using **Supabase Online** (not running locally), you must deploy your changes to the cloud for them to work. The local frontend at `localhost:5173` needs to talk to the real remote Edge Function.

## 1. Prerequisites

Ensure you are logged in to the Supabase CLI and linked to your project:

```powershell
npx supabase login
npx supabase link --project-ref your-project-id
```
*(Replace `your-project-id` with the reference from your Supabase dashboard URL: `https://supabase.com/dashboard/project/your-project-id`)*

## 2. Push Database Changes

The `zoho_oauth_tokens` table likely doesn't exist in your remote database yet.

```powershell
npx supabase db push
```
*This will apply the migration `20250122000000_create_zoho_oauth_tokens.sql` to your live database.*

## 3. Set Remote Secrets

The remote Edge Function needs your Zoho credentials to work. These are NOT automatically copied from your local `.env` file for security reasons.

```powershell
npx supabase secrets set ZOHO_CLIENT_ID=1000.6YSK4H9LU3HR06HKN65L6YBYCRGGTI
npx supabase secrets set ZOHO_CLIENT_SECRET=YOUR_ACTUAL_SECRET_HERE
```

## 4. Deploy Edge Function

You need to deploy the `zoho-oauth-callback` function to the cloud.

```powershell
npx supabase functions deploy zoho-oauth-callback
```

## 5. Verify Frontend Configuration

Check your `.env` or `.env.local` file used by the frontend.

```env
# This must point to your REMOTE project, NOT 127.0.0.1
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

## 6. Troubleshooting

If it still fails:
1.  Go to the Supabase Dashboard > Edge Functions > `zoho-oauth-callback` > Logs.
2.  Watch these logs while you click "Connect" in the app.
3.  If you see no logs, the frontend is hitting the wrong URL. Check the Network tab in your browser (F12).


