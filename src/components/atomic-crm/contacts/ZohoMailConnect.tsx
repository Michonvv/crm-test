import { Mail, ExternalLink } from "lucide-react";
import { useGetIdentity } from "ra-core";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "../providers/supabase/supabase";

const ZOHO_CLIENT_ID = import.meta.env.VITE_ZOHO_CLIENT_ID || "1000.6YSK4H9LU3HR06HKN65L6YBYCRGGTI";
const ZOHO_DATA_CENTER = import.meta.env.VITE_ZOHO_DATA_CENTER || "eu";

// Get redirect URI - Zoho OAuth doesn't support hash fragments in redirect_uri
// So we redirect to a static HTML file that will convert path-based URL to hash-based route
const getRedirectUri = () => {
  const origin = window.location.origin;
  return `${origin}/zoho-callback.html`;
};

const AUTH_URLS: Record<string, string> = {
  us: "https://accounts.zoho.com/oauth/v2/auth",
  eu: "https://accounts.zoho.eu/oauth/v2/auth",
  in: "https://accounts.zoho.in/oauth/v2/auth",
  au: "https://accounts.zoho.com.au/oauth/v2/auth",
  jp: "https://accounts.zoho.jp/oauth/v2/auth",
};

export const ZohoMailConnect = () => {
  const { identity } = useGetIdentity();
  const location = useLocation();
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    if (!identity?.id) {
      alert("Please log in to connect Zoho Mail");
      return;
    }

    setIsConnecting(true);

    try {
      // identity.id is already the sales_id (from authProvider.getIdentity)
      // No need to query the sales table - just use identity.id directly

      // Build OAuth URL
      const redirectUri = getRedirectUri();
      console.log("Zoho OAuth redirect URI:", redirectUri);
      
      // According to Zoho Mail API docs:
      // - ZohoMail.accounts.READ is needed to get account ID (GET /api/accounts)
      // - ZohoMail.messages.ALL is needed to search and read emails
      // Scopes must be space-separated, not comma-separated
      const scopes = "ZohoMail.accounts.READ ZohoMail.messages.ALL";
      
      const authUrl = `${AUTH_URLS[ZOHO_DATA_CENTER]}?` +
        `client_id=${ZOHO_CLIENT_ID}&` +
        `response_type=code&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `scope=${encodeURIComponent(scopes)}&` +
        `access_type=offline&` +
        `prompt=consent`;
      
      console.log("Zoho OAuth URL:", authUrl);

      // Store current location to return to after OAuth
      sessionStorage.setItem("zoho_oauth_return_to", location.pathname);

      // Redirect to Zoho OAuth
      window.location.href = authUrl;
    } catch (error) {
      console.error("Error initiating Zoho OAuth:", error);
      alert("Failed to connect to Zoho Mail. Please try again.");
      setIsConnecting(false);
    }
  };

  return (
    <div className="mt-4 p-4 border rounded-lg bg-muted/50">
      <div className="flex items-center gap-2 mb-2">
        <Mail className="w-5 h-5 text-muted-foreground" />
        <h6 className="text-sm font-semibold">Zoho Mail Integration</h6>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Connect your Zoho Mail account to view emails from contacts.
      </p>
      <Button
        onClick={handleConnect}
        disabled={isConnecting}
        size="sm"
        className="flex items-center gap-2"
      >
        <ExternalLink className="w-4 h-4" />
        {isConnecting ? "Connecting..." : "Connect Zoho Mail"}
      </Button>
    </div>
  );
};

