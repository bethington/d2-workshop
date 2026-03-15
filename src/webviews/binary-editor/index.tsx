import React from "react";
import { createRoot } from "react-dom/client";
import { BinaryEditor } from "./BinaryEditor";

const root = createRoot(document.getElementById("root")!);
root.render(<BinaryEditor />);
