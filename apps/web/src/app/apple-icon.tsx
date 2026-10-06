import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the Cascade mark (one node splitting into two) on ink. */
export default function AppleIcon(): ImageResponse {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1826" }}>
        <svg width="120" height="120" viewBox="0 0 24 24" fill="none">
          <rect x="8.5" y="2" width="7" height="6" rx="1.8" fill="#e7eef6" />
          <path d="M12 8v3.5M12 11.5H6.5V15M12 11.5h5.5V15" stroke="#e7eef6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="3" y="15" width="7" height="6" rx="1.8" stroke="#e7eef6" strokeWidth="1.6" />
          <rect x="14" y="15" width="7" height="6" rx="1.8" fill="#8cb4ff" />
        </svg>
      </div>
    ),
    size,
  );
}
