/**
 * The hero's background: payments (gold dots) flow along lanes toward a spending limit. Most pass;
 * now and then one hits the limit, turns red and fades: blocked. Decorative only.
 */
const lanes = [90, 170, 250, 330, 410, 490, 570, 650];

// [lane, duration s, delay s, blocked]
const dots: [number, number, number, boolean][] = [
  [0, 14, 0, false],
  [1, 11, 3, false],
  [2, 16, 1, true],
  [3, 12, 6, false],
  [4, 15, 2, false],
  [5, 13, 8, true],
  [6, 17, 4, false],
  [7, 12, 1, false],
  [0, 13, 9, false],
  [2, 12, 10, false],
  [3, 18, 12, true],
  [4, 11, 13, false],
  [6, 14, 11, false],
  [1, 16, 14, true],
  [5, 12, 15, false],
  [7, 15, 16, false],
];

export function Flow() {
  return (
    <svg
      className="flow-mask pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1200 720"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {lanes.map((y) => (
        <line key={y} x1="0" x2="1200" y1={y} y2={y} className="stroke-line" strokeWidth="1" />
      ))}
      {/* The limit: payments past it only if the rules allow. */}
      <line
        x1="800"
        x2="800"
        y1="40"
        y2="700"
        className="stroke-seal"
        strokeWidth="1.5"
        strokeDasharray="4 7"
        opacity="0.7"
      />
      {dots.map(([lane, duration, delay, blocked], i) => (
        <circle
          key={i}
          cx="-20"
          cy={lanes[lane]}
          r="4"
          className="fill-seal"
          style={{
            animation: `${blocked ? "flow-block" : "flow-pass"} ${duration}s linear ${delay}s infinite both`,
          }}
        />
      ))}
    </svg>
  );
}
