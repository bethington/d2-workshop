import React from "react";
import { createRoot } from "react-dom/client";
import { PL2Viewer } from "./PL2Viewer";

const root = createRoot(document.getElementById("root")!);
root.render(<PL2Viewer />);
