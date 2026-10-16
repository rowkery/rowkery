import localFont from "next/font/local";

// The coming-soon page's face: IBM Plex Sans in the two weights it sets (app/soon.css), for
// its root layout and the 404 of the coming-soon build, which carries its own <html>.
export const soonSans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500" },
  ],
  variable: "--font-sans",
  display: "swap",
});
