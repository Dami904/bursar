/** A gold wax seal: scalloped edge, inner ring, the b at its heart, and the words around the rim. */
export function WaxSeal({ size = 96, className = "" }: { size?: number; className?: string }) {
  // The scalloped edge: 24 bumps around the disc.
  const bumps = 24;
  let edge = "";
  for (let i = 0; i <= bumps * 2; i += 1) {
    const angle = (Math.PI * i) / bumps;
    const r = i % 2 === 0 ? 48 : 45;
    edge += `${i === 0 ? "M" : "L"}${(50 + r * Math.cos(angle)).toFixed(2)} ${(50 + r * Math.sin(angle)).toFixed(2)}`;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-label="Anchored on Arc"
      role="img"
    >
      <defs>
        {/* 250° of the rim, over the top from lower left to lower right: the words sit on it once, centred. */}
        <path id="seal-rim" d="M22.97 68.93 A33 33 0 1 1 77.03 68.93" />
      </defs>
      <path d={`${edge}Z`} fill="#B08A2E" />
      <circle cx="50" cy="50" r="41" fill="none" stroke="#8C6C1F" strokeWidth="1.5" />
      <circle cx="50" cy="50" r="24" fill="#C49A38" stroke="#8C6C1F" strokeWidth="1" />
      <text
        fill="#F6EDD6"
        textAnchor="middle"
        fontSize="9"
        fontWeight="600"
        letterSpacing="1.8"
        fontFamily="Inter Variable, sans-serif"
      >
        <textPath href="#seal-rim" startOffset="50%">
          ANCHORED ON ARC
        </textPath>
      </text>
      <circle cx="50" cy="84" r="1.6" fill="#F6EDD6" />
      <circle cx="43" cy="83" r="1.1" fill="#F6EDD6" />
      <circle cx="57" cy="83" r="1.1" fill="#F6EDD6" />
      {/* The b: stem and coin. */}
      <rect x="42" y="36" width="4.5" height="27" rx="2.25" fill="#F6EDD6" />
      <circle cx="54" cy="55" r="7.5" fill="none" stroke="#F6EDD6" strokeWidth="4" />
    </svg>
  );
}
