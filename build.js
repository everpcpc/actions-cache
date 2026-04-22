const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const nativeNodePlugin = {
  name: "native-node",
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => {
      return { path: args.path, external: true };
    });
    build.onResolve({ filter: /^@opendal\/lib-/ }, (args) => {
      return { path: args.path, external: true };
    });
  },
};

const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64-msvc",
];

function copyNativeFiles(outdir) {
  for (const platform of platforms) {
    const pkgDir = path.join(
      __dirname,
      "node_modules",
      "@opendal",
      `lib-${platform}`
    );
    if (!fs.existsSync(pkgDir)) continue;
    for (const file of fs.readdirSync(pkgDir)) {
      if (file.endsWith(".node")) {
        fs.copyFileSync(path.join(pkgDir, file), path.join(outdir, file));
      }
    }
  }
}

async function build() {
  const common = {
    bundle: true,
    platform: "node",
    target: "node24",
    plugins: [nativeNodePlugin],
  };

  await esbuild.build({
    ...common,
    entryPoints: ["src/restore.ts"],
    outfile: "dist/restore/index.js",
  });

  await esbuild.build({
    ...common,
    entryPoints: ["src/save.ts"],
    outfile: "dist/save/index.js",
  });

  copyNativeFiles("dist/restore");
  copyNativeFiles("dist/save");
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
