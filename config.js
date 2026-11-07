// Marli Cab configuration.
// The anon key is meant to be public; the database rules in supabase/schema.sql protect the data.
window.MARLI_CONFIG = {
  SUPABASE_URL: "https://tnjtbgzujiedcreikxks.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRuanRiZ3p1amllZGNyZWlreGtzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwMDk0MDMsImV4cCI6MjEwOTU4NTQwM30.rF599BWdWUdM-w7CvgekVlLi5mSPjSYjxnVe0iObsk4",
  CURRENCY: "R",          // shown before fares
  BASE_FARE: 80,          // flat starting fee
  PER_KM: 0,              // price per kilometre
  MIN_FARE: 80,           // never charge less than this
  DEFAULT_CENTER: [-27.9774, 26.735], // Welkom, Free State
  COUNTRY_CODES: "za"     // limits address search to South Africa
};
