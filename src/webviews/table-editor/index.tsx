import React from "react";
import { createRoot } from "react-dom/client";
import { TableEditor } from "./TableEditor";

const root = createRoot(document.getElementById("root")!);
root.render(<TableEditor />);
