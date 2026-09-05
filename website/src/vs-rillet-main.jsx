import React from "react";
import ReactDOM from "react-dom/client";
import { SpeedInsights } from "@vercel/speed-insights/react";
import VsRilletApp from "./VsRilletApp.jsx";
import { initAnalytics } from "./lib/analytics.js";
import "./index.css";

initAnalytics();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <VsRilletApp />
    <SpeedInsights />
  </React.StrictMode>
);
