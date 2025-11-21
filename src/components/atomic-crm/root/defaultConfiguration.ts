import { Mars, NonBinary, Venus } from "lucide-react";

export const defaultDarkModeLogo = "./logos/guestri.png";
export const defaultLightModeLogo = "./logos/guestri.png";

export const defaultTitle = "guestri CRM";

export const defaultCompanySectors = [
  "Apartment",
  "House",
  "Villa",
  "Condo",
  "Cottage",
  "Bungalow",
  "Cabin",
  "Loft",
  "Townhouse",
  "Other",
];

export const defaultDealStages = [
  { value: "lead", label: "Lead" },
  { value: "outreach", label: "Outreach" },
  { value: "trailing", label: "Trailing" },
  { value: "onboarding", label: "Onboarding" },
  { value: "subscription", label: "Subscription" },
  { value: "churned", label: "Churned" },
];

export const defaultDealPipelineStatuses = ["subscription"];

export const defaultDealCategories = [
  "SaaS Subscription",
  "Enterprise Plan",
  "Add-on Service",
  "Consulting",
];

export const defaultNoteStatuses = [
  { value: "cold", label: "Cold", color: "#7dbde8" },
  { value: "warm", label: "Warm", color: "#e8cb7d" },
  { value: "hot", label: "Hot", color: "#e88b7d" },
  { value: "in-contract", label: "In Contract", color: "#a4e87d" },
];

export const defaultTaskTypes = [
  "None",
  "Email",
  "Demo",
  "Lunch",
  "Meeting",
  "Follow-up",
  "Thank you",
  "Ship",
  "Call",
];

export const defaultContactGender = [
  { value: "male", label: "He/Him", icon: Mars },
  { value: "female", label: "She/Her", icon: Venus },
  { value: "nonbinary", label: "They/Them", icon: NonBinary },
];
