import { useEffect, useState } from "react";

// 1024px, not Tailwind's md (768): ScrollPipeline's exploded layout needs
// real width for four corner callouts around a ~420px document card without
// crowding, on top of the vertical scroll room a pinned sequence needs to
// not feel cramped. Below it, the static list (HowItWorks) is the better
// experience anyway, not a lesser one -- see App.jsx.
const QUERY = "(min-width: 1024px)";

export default function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsDesktop(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isDesktop;
}
