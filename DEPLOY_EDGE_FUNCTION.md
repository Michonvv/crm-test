# CRITICAL: Deploy Edge Function to Supabase

**The edge function is NOT deployed to your remote Supabase project.** That's why it's not being hit.

## Step-by-Step Deployment

### 1. Login to Supabase CLI
```powershell
npx supabase login
```
*(This will open a browser to authenticate)*

### 2. Link Your Project
Get your project reference ID from your Supabase dashboard URL:
- Dashboard URL: `https://supabase.com/dashboard/project/abc123xyz`
- Project ID: `abc123xyz`

```powershell
npx supabase link --project-ref YOUR_PROJECT_ID
```
*(Enter your database password when prompted)*

### 3. Deploy the Function
```powershell
npx supabase functions deploy zoho-oauth-callback --no-verify-jwt
```

**Expected output:**
```
Deploying function zoho-oauth-callback...
Function zoho-oauth-callback deployed successfully
```

### 4. Set Secrets (REQUIRED)
The function needs your Zoho credentials:

```powershell
npx supabase secrets set ZOHO_CLIENT_ID=1000.6YSK4H9LU3HR06HKN65L6YBYCRGGTI
npx supabase secrets set ZOHO_CLIENT_SECRET=YOUR_ACTUAL_SECRET_HERE
```

### 5. Verify Deployment
Check your Supabase Dashboard:
- Go to: **Edge Functions** → **zoho-oauth-callback**
- You should see the function listed
- Click on it to see logs

### 6. Test the Function URL
After deployment, test if it's reachable:
```powershell
# Replace with your actual project URL
curl -X OPTIONS https://YOUR_PROJECT_ID.supabase.co/functions/v1/zoho-oauth-callback -H "apikey: YOUR_ANON_KEY"
```

Should return: `204 No Content` (CORS preflight success)

## Common Issues

### "Function not found" (404)
- Function wasn't deployed
- Wrong project ID
- Function name typo

### "Zoho OAuth is not configured" (500)
- Secrets not set
- Wrong secret names

### "Cannot reach edge function"
- Function not deployed
- Wrong `VITE_SUPABASE_URL` in `.env`
- Network/CORS issue

## Verify Your .env File

Make sure your `.env` has:
```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

**NO trailing slashes!**

