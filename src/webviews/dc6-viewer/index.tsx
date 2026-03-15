import React from "react";
import { createRoot } from "react-dom/client";
import { DC6Viewer } from "./DC6Viewer";

const root = createRoot(document.getElementById("root")!);
root.render(<DC6Viewer />);
