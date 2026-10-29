import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appHome, packageRoot } from "./paths.ts";

const destination = join(packageRoot, "types");
mkdirSync(destination, { recursive: true });
for (const name of ["gpui-kit.d.ts", "herdr.d.ts"])
  copyFileSync(join(appHome, name), join(destination, name));
