import { mount } from "../../shared";
import { App } from "./App";

// a plain browser (pnpm modules:dev) has no Shellmosaic host: fake one with a simulated team
if (import.meta.env.DEV && !window.shellmosaic) (await import("./dev-mock")).install();
mount(App);
