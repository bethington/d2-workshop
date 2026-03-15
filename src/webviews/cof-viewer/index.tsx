import React from "react";
import { createRoot } from "react-dom/client";
import { COFViewer } from "./COFViewer";

const root = createRoot(document.getElementById("root")!);
root.render(<COFViewer />);
