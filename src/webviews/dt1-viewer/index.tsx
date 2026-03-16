import React from "react";
import { createRoot } from "react-dom/client";
import { DT1Viewer } from "./DT1Viewer";

const root = createRoot(document.getElementById("root")!);
root.render(<DT1Viewer />);
