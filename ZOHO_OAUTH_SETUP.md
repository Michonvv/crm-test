# Zoho Mail OAuth Setup Guide

This guide explains how to set up the Zoho Mail OAuth integration for Atomic CRM.

## Overview

The Zoho Mail integration now uses a user-based OAuth flow. Each user can connect their own Zoho Mail account directly from the application, making it much simpler than server-side OAuth.

## Setup Steps

### 1. Create Zoho OAuth Application

1. Go to [Zoho Developer Console](https://accounts.zoho.com/developerconsole)
2. Click **"Add Client"** or **"CREATE NOW"**
3. Select **"Server-based Applications"**
4. Fill in the details:
   - **Client Name**: Atomic CRM (or your app name)
   - **Homepage URL**: Your application URL (e.g., `https://yourdomain.com`)
   - **Authorized Redirect URIs**: `https://yourdomain.com/zoho-callback` (or `http://localhost:5173/zoho-callback` for local dev)
5. Click **CREATE**
6. Note down your **Client ID** and **Client Secret**

### 2. Set Environment Variables

#### Frontend (.env or .env.local)

```bash
VITE_ZOHO_CLIENT_ID=your_client_id_here
VITE_ZOHO_CLIENT_SECRET=your_client_secret_here
VITE_ZOHO_DATA_CENTER=eu  # or us, in, au, jp based on your region
```

#### Supabase Secrets (for token refresh)

```bash
npx supabase secrets set ZOHO_CLIENT_ID=your_client_id_here
npx supabase secrets set ZOHO_CLIENT_SECRET=your_client_secret_here
```

**Note**: The `ZOHO_DATA_CENTER` is optional and defaults to `eu`. Users' data centers are stored per-connection.

### 3. Run Database Migration

Apply the migration to create the OAuth tokens table:

```bash
npx supabase migration up
```

Or if using Supabase CLI locally:

```bash
npx supabase db reset
```

### 4. Deploy Edge Function

```bash
npx supabase functions deploy zoho-mail
```

### 5. Update Redirect URI in Zoho

Make sure the redirect URI in your Zoho Developer Console matches:
- **Production**: `https://yourdomain.com/zoho-callback`
- **Local Development**: `http://localhost:5173/zoho-callback` (or your dev port)

## How It Works

1. **User clicks "Connect Zoho Mail"** on a contact page
2. **User is redirected to Zoho** for authorization
3. **User authorizes** the application
4. **Zoho redirects back** with an authorization code
5. **Application exchanges code for tokens** and stores them in the database
6. **Tokens are used** to fetch emails when viewing contacts

## User Experience

- When viewing a contact, if Zoho Mail is not connected, users see a "Connect Zoho Mail" button
- After connecting, emails from that contact are automatically displayed
- Each user connects their own Zoho Mail account
- Tokens are automatically refreshed when they expire

## Troubleshooting

### "Zoho Mail not connected" error
- Make sure the user has clicked "Connect Zoho Mail" and completed the OAuth flow
- Check that tokens are stored in the `zoho_oauth_tokens` table

### "Invalid redirect URI" error
- Verify the redirect URI in Zoho Developer Console matches exactly (including http/https and port)
- Check that `VITE_ZOHO_CLIENT_ID` is set correctly

### "Failed to refresh token" error
- Verify `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` are set in Supabase secrets
- Check that the refresh token hasn't been revoked in Zoho

## Security Notes

- OAuth tokens are stored encrypted in the database
- Each user can only access their own tokens (RLS policies)
- Tokens are automatically refreshed before expiration
- Client secret should NEVER be exposed in frontend code (only in Supabase secrets)

