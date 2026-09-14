import React from "react";
import { createRoot } from "react-dom/client";

// The two faces the brief names, bundled rather than fetched: the renderer's
// CSP allows nothing remote, and an offline machine should not fall back to
// the system font.
import "@fontsource/archivo/latin-400.css";
import "@fontsource/archivo/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";

import App from "./App.jsx";
import Hud from "./Hud.jsx";
import "./index.css";

// Two windows, one bundle. The hash decides which — simpler than a second Vite
// entry, and the HUD shares the store and styles either way.
const isHud = window.location.hash === "#/hud";
if (isHud) document.body.classList.add("hud");

createRoot(document.getElementById("root")).render(
  <React.StrictMode>{isHud ? <Hud /> : <App />}</React.StrictMode>
);
