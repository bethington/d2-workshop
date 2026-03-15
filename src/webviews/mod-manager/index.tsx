import React from "react";
import { createRoot } from "react-dom/client";
import { ModManager } from "./ModManager";

const root = createRoot(document.getElementById("root")!);
root.render(<ModManager />);
