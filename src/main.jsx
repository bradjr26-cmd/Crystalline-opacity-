import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import LiveTurret from "./LiveTurret";
import GuardianLens from "./GuardianLens";
import GroundwaterLevels from "./GroundwaterLevels";
import CrystalComposer from "./CrystalComposer";
import HunterMode from "./HunterMode";

const TOOLS = [
  { id: "turret", label: "the live turret", component: LiveTurret },
  { id: "guardian", label: "GuardianLens", component: GuardianLens },
  { id: "groundwater", label: "Groundwater Levels", component: GroundwaterLevels },
  { id: "crystal", label: "Crystal Composer", component: CrystalComposer },
  { id: "hunter", label: "Hunter Mode", component: HunterMode },
];

function App() {
  const [active, setActive] = useState("turret");
  const Tool = TOOLS.find((t) => t.id === active).component;

  return (
    <>
      <div style={{
        display: "flex", gap: 0,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11, borderBottom: "1px solid #1b2638",
        background: "#05070d",
      }}>
        {TOOLS.map((t) => (
          <button key={t.id} onClick={() => setActive(t.id)} style={{
            padding: "9px 16px", cursor: "pointer", border: "none",
            borderBottom: `2px solid ${active === t.id ? "#aef0c8" : "transparent"}`,
            background: "transparent",
            color: active === t.id ? "#e6ecf5" : "#566077",
            fontFamily: "inherit", fontSize: "inherit",
          }}>{t.label}</button>
        ))}
      </div>
      <Tool />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
