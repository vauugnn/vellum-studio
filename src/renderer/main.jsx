import React from "react";
import { createRoot } from "react-dom/client";

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
