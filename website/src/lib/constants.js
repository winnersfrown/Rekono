// The deployed app lives on a different origin (Render), so every
// sign-in/get-started link across the site points at it explicitly rather
// than relying on relative paths that would 404 on a marketing-site-only
// deploy. Kept in one place so a redeploy to a new host is a one-line change
// instead of a find-and-replace across every component.
export const APP_URL = "https://rekono-couj.onrender.com";
export const DEMO_URL = `${APP_URL}/?demo=1`;
export const PRIVACY_URL = `${APP_URL}/privacy.html`;
export const TERMS_URL = `${APP_URL}/terms.html`;
export const CONTACT_MAILTO = "mailto:wfrownusa@yahoo.com?subject=Rekono%20design%20partnership";

// Same easing curve as the app's own design system (backend/public/styles.css
// --ease) and the previous static site -- a soft, springy ease-out that
// reads as more "designed" than the default linear/ease-in-out curves.
export const EASE = [0.16, 1, 0.3, 1];
