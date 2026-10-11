import fs from "node:fs";
import path from "node:path";

interface FileEntry {
  fullPath: string;
  dir: string;
  name: string;
  rootRelPath: string;
}

interface DirEntry {
  fullPath: string;
  parentDir: string;
  name: string;
  rootRelPath: string;
  depth: number;
}

interface UnresolvedLink {
  sourceFile: string;
  originalUrl: string;
  resolvedTarget: string;
  tag: string;
}

const ROOT_DIR = path.resolve(import.meta.dir, "..");

const EXCLUDED_NAMES = new Set([".git", "CNAME", ".gitignore", ".gitattributes", "scripts"]);

/**
 * Normalizes a single path segment:
 * - lowercase
 * - remove commas
 * - convert whitespace to hyphens
 */
export function normalizeSegment(name: string): string {
  if (EXCLUDED_NAMES.has(name) || name.startsWith(".git")) {
    return name;
  }
  return name
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Normalizes a relative path by normalizing each segment.
 */
export function normalizeRelativePath(relPath: string): string {
  return relPath
    .split("/")
    .map(seg => (seg === "" || seg === "." || seg === ".." ? seg : normalizeSegment(seg)))
    .join("/");
}

/**
 * Cleans author typos in URLs:
 * - trims leading/trailing whitespace
 * - normalizes Windows backslashes to forward slashes
 * - strips erroneous trailing periods (e.g., "Android Tab.html.")
 */
export function cleanUrl(raw: string): string {
  let cleaned = raw.trim().replace(/\\/g, "/");
  if (cleaned.endsWith(".") && !cleaned.endsWith("..")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

/**
 * Formats a relative URL from a directory relative to root to a target relative to root.
 * Guarantees that the URL starts with `./` or `../`.
 * Never returns bare/unprefixed paths or absolute paths.
 */
export function formatRelativeUrl(fromDirRootRel: string, targetRootRel: string): string {
  const normalizedFrom = fromDirRootRel === "." ? "" : fromDirRootRel;
  let rel = path.relative(normalizedFrom, targetRootRel);
  if (!rel.startsWith(".") && !rel.startsWith("/")) {
    rel = "./" + rel;
  }
  return rel;
}

/**
 * Checks whether a URL is external or anchor-only.
 */
export function isExternalOrAnchor(url: string): boolean {
  return (
    url.startsWith("http:") ||
    url.startsWith("https:") ||
    url.startsWith("mailto:") ||
    url.startsWith("javascript:") ||
    url.startsWith("ftp:") ||
    url.startsWith("data:") ||
    url.startsWith("#")
  );
}

/**
 * Recursively scans the filesystem starting from a directory.
 */
function scanFilesystem(baseDir: string): { files: FileEntry[]; dirs: DirEntry[] } {
  const files: FileEntry[] = [];
  const dirs: DirEntry[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "scripts") {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const rootRelPath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        const depth = rootRelPath.split(path.sep).length;
        dirs.push({
          fullPath,
          parentDir: currentDir,
          name: entry.name,
          rootRelPath,
          depth,
        });
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push({
          fullPath,
          dir: currentDir,
          name: entry.name,
          rootRelPath,
        });
      }
    }
  }

  walk(baseDir);
  return { files, dirs };
}

/**
 * Compiles a Set of all available file paths relative to ROOT_DIR on disk.
 */
export function getAvailablePaths(baseDir: string = ROOT_DIR): Set<string> {
  const available = new Set<string>();
  const { files } = scanFilesystem(baseDir);
  for (const f of files) {
    available.add(path.normalize(f.rootRelPath));
  }
  return available;
}

/**
 * Rewrites URLs in an HTML file using HTMLRewriter and strict relative path rules.
 */
async function rewriteHtmlContent(
  htmlContent: string,
  fileRootRel: string,
  availablePaths: Set<string>,
  unresolvedLinks: UnresolvedLink[]
): Promise<{ rewritten: string; linkCount: number }> {
  // Pre-fix legacy author typo: `<href="Draw Event.html">` -> `<a href="./draw-event.html">`
  let processed = htmlContent.replace(/<href="([^"]+)">/gi, (_match, target) => {
    return `<a href="${target}">`;
  });

  const fromDirRootRel = path.dirname(fileRootRel);
  let linkCount = 0;

  function processUrl(rawUrl: string, tagName: string): string {
    const cleaned = cleanUrl(rawUrl);
    if (isExternalOrAnchor(cleaned)) {
      return cleaned;
    }

    linkCount++;
    const hashIndex = cleaned.indexOf("#");
    const pathPart = hashIndex !== -1 ? cleaned.slice(0, hashIndex) : cleaned;
    const hashPart = hashIndex !== -1 ? cleaned.slice(hashIndex) : "";

    let decoded = pathPart;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      // Fallback if not URI encoded
    }

    const normPath = normalizeRelativePath(decoded);
    const targetRootRel = path.normalize(path.join(fromDirRootRel, normPath));

    if (!availablePaths.has(targetRootRel)) {
      unresolvedLinks.push({
        sourceFile: fileRootRel,
        originalUrl: rawUrl,
        resolvedTarget: targetRootRel,
        tag: tagName,
      });
    }

    const newRelUrl = formatRelativeUrl(fromDirRootRel, targetRootRel);
    return hashPart ? `${newRelUrl}${hashPart}` : newRelUrl;
  }

  const rewriter = new HTMLRewriter()
    .on("a", {
      element(el) {
        const href = el.getAttribute("href");
        if (href) {
          el.setAttribute("href", processUrl(href, "a"));
        }
      },
    })
    .on("img", {
      element(el) {
        const src = el.getAttribute("src");
        if (src) {
          el.setAttribute("src", processUrl(src, "img"));
        }
      },
    })
    .on("link", {
      element(el) {
        const href = el.getAttribute("href");
        if (href) {
          el.setAttribute("href", processUrl(href, "link"));
        }
      },
    });

  const rewritten = await rewriter.transform(new Response(processed)).text();
  return { rewritten, linkCount };
}

/**
 * Verifies all HTML links against disk without performing renames.
 */
export async function verifyLinks(baseDir: string = ROOT_DIR) {
  console.log(`\n🔍 Verifying links in ${baseDir}...`);
  const availablePaths = getAvailablePaths(baseDir);
  console.log(`Available paths catalog size: ${availablePaths.size}`);

  const { files } = scanFilesystem(baseDir);
  const htmlFiles = files.filter(f => f.name.endsWith(".html"));
  console.log(`HTML files to check: ${htmlFiles.length}`);

  const unresolvedLinks: UnresolvedLink[] = [];
  let totalCheckedLinks = 0;

  for (const file of htmlFiles) {
    const content = fs.readFileSync(file.fullPath, "utf8");
    const { linkCount } = await rewriteHtmlContent(content, file.rootRelPath, availablePaths, unresolvedLinks);
    totalCheckedLinks += linkCount;
  }

  console.log(`Total internal links checked: ${totalCheckedLinks}`);
  console.log(`Resolved links: ${totalCheckedLinks - unresolvedLinks.length}`);
  console.log(`Unresolved links: ${unresolvedLinks.length}`);

  if (unresolvedLinks.length > 0) {
    console.log(`\n⚠️  Unresolved links:`);
    for (const item of unresolvedLinks.slice(0, 15)) {
      console.log(`  [${item.tag}] in ${item.sourceFile} -> "${item.originalUrl}" (resolved to: "${item.resolvedTarget}")`);
    }
  } else {
    console.log(`\n✨ 100% of internal links resolved successfully! Zero broken references.`);
  }

  return { totalCheckedLinks, unresolvedLinks };
}

/**
 * Main execution function.
 */
async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isVerifyOnly = args.includes("--verify-only");

  console.log("==================================================");
  console.log("📁 GameMaker Docs Normalizer (Bun Zero-Dependency)");
  console.log("==================================================");
  console.log(`Workspace Root: ${ROOT_DIR}`);
  console.log(`Mode: ${isVerifyOnly ? "Verify Only" : isDryRun ? "DRY RUN (simulation)" : "EXECUTE (direct on disk)"}\n`);

  if (isVerifyOnly) {
    await verifyLinks(ROOT_DIR);
    return;
  }

  // 1. Initial Scan
  const initialScan = scanFilesystem(ROOT_DIR);
  console.log(`Found ${initialScan.files.length} files and ${initialScan.dirs.length} directories.`);

  // 2. Cleanup dangling Android Tab.html_ if present
  const backupFile = initialScan.files.find(f => f.name === "Android Tab.html_");
  if (backupFile) {
    console.log(`🗑️  Detected unreferenced backup file: ${backupFile.rootRelPath}`);
    if (!isDryRun) {
      fs.unlinkSync(backupFile.fullPath);
      console.log(`   Deleted ${backupFile.rootRelPath}`);
    } else {
      console.log(`   [DRY RUN] Would delete ${backupFile.rootRelPath}`);
    }
  }

  // 3. Plan File Renames
  const filesToRename = initialScan.files.filter(f => {
    if (f.name === "Android Tab.html_") return false;
    const norm = normalizeSegment(f.name);
    return f.name !== norm;
  });
  console.log(`Files needing normalization: ${filesToRename.length}`);

  // 4. Plan Directory Renames (bottom-up: deepest first)
  const dirsToRename = initialScan.dirs
    .filter(d => {
      const norm = normalizeSegment(d.name);
      return d.name !== norm;
    })
    .sort((a, b) => b.depth - a.depth);
  console.log(`Directories needing normalization: ${dirsToRename.length}`);

  if (isDryRun) {
    console.log("\n[DRY RUN] Simulating available paths post-rename...");
    const simulatedPaths = new Set<string>();
    for (const f of initialScan.files) {
      if (f.name === "Android Tab.html_") continue;
      const normPath = normalizeRelativePath(f.rootRelPath);
      simulatedPaths.add(path.normalize(normPath));
    }
    console.log(`[DRY RUN] Post-rename catalog size: ${simulatedPaths.size}`);

    const unresolvedLinks: UnresolvedLink[] = [];
    let linkCountTotal = 0;
    const htmlFiles = initialScan.files.filter(f => f.name.endsWith(".html"));

    for (const file of htmlFiles) {
      const normFile = normalizeRelativePath(file.rootRelPath);
      const content = fs.readFileSync(file.fullPath, "utf8");
      const { linkCount } = await rewriteHtmlContent(content, normFile, simulatedPaths, unresolvedLinks);
      linkCountTotal += linkCount;
    }

    console.log(`[DRY RUN] Total internal links checked: ${linkCountTotal}`);
    console.log(`[DRY RUN] Successfully resolved links: ${linkCountTotal - unresolvedLinks.length}`);
    console.log(`[DRY RUN] Unresolved links: ${unresolvedLinks.length}`);
    if (unresolvedLinks.length === 0) {
      console.log("✨ 100% of internal links resolved in simulation!");
    }
    console.log("\n✅ Dry run completed successfully! Run without --dry-run to apply changes.");
    return;
  }

  // EXECUTION MODE
  // Phase 1: Rename files in-place
  console.log("\n✏️  Phase 1: Renaming files in-place...");
  let filesRenamed = 0;
  for (const file of filesToRename) {
    const normName = normalizeSegment(file.name);
    const newPath = path.join(file.dir, normName);
    fs.renameSync(file.fullPath, newPath);
    filesRenamed++;
  }
  console.log(`   Renamed ${filesRenamed} files.`);

  // Phase 2: Rename directories bottom-up
  console.log("\n📁 Phase 2: Renaming directories bottom-up...");
  const liveScanDirs = scanFilesystem(ROOT_DIR).dirs.sort((a, b) => b.depth - a.depth);
  let dirsRenamed = 0;
  for (const dir of liveScanDirs) {
    const normName = normalizeSegment(dir.name);
    if (dir.name !== normName) {
      const newPath = path.join(dir.parentDir, normName);
      fs.renameSync(dir.fullPath, newPath);
      dirsRenamed++;
    }
  }
  console.log(`   Renamed ${dirsRenamed} directories.`);

  // Phase 3: Compile post-rename available paths catalog
  console.log("\n📋 Phase 3: Compiling post-rename available paths catalog...");
  const availablePaths = getAvailablePaths(ROOT_DIR);
  console.log(`   Total available paths catalog size: ${availablePaths.size}`);

  // Phase 4: Rewrite HTML references with HTMLRewriter
  console.log("\n🔄 Phase 4: Rewriting HTML references with HTMLRewriter...");
  const postRenameFiles = scanFilesystem(ROOT_DIR).files;
  const htmlFiles = postRenameFiles.filter(f => f.name.endsWith(".html"));
  console.log(`   Processing ${htmlFiles.length} HTML files...`);

  const unresolvedLinks: UnresolvedLink[] = [];
  let totalLinksUpdated = 0;
  let htmlFilesUpdated = 0;

  for (const file of htmlFiles) {
    const originalContent = fs.readFileSync(file.fullPath, "utf8");
    const { rewritten, linkCount } = await rewriteHtmlContent(
      originalContent,
      file.rootRelPath,
      availablePaths,
      unresolvedLinks
    );

    totalLinksUpdated += linkCount;
    if (rewritten !== originalContent) {
      fs.writeFileSync(file.fullPath, rewritten, "utf8");
      htmlFilesUpdated++;
    }
  }

  console.log(`   HTML files modified: ${htmlFilesUpdated}`);
  console.log(`   Total internal references processed: ${totalLinksUpdated}`);
  console.log(`   Resolved internal references: ${totalLinksUpdated - unresolvedLinks.length}`);
  console.log(`   Unresolved internal references: ${unresolvedLinks.length}`);

  // Phase 5: Verification check on disk
  console.log("\n🔎 Phase 5: Performing post-normalization verification...");
  await verifyLinks(ROOT_DIR);

  console.log("\n==================================================");
  console.log("🎉 Normalization complete!");
  console.log("==================================================");
}

if (import.meta.main) {
  main().catch(err => {
    console.error("❌ Error during normalization:", err);
    process.exit(1);
  });
}
