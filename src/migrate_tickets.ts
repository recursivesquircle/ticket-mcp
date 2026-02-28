import fs from "fs";
import path from "path";
import fg from "fast-glob";
import { REQUIRED_BODY_HEADERS } from "./server";

const repoRoot = process.env.TICKET_ROOT ?? path.resolve(process.cwd(), "..", "..");

async function migrateTickets() {
    const patterns = [
        "tickets/pending/**/*.md",
        "tickets/in_progress/**/*.md",
        "tickets/awaiting_human_test/**/*.md",
        "tickets/done/**/*.md",
        "tickets/archive/**/*.md",
    ];

    const files = await fg(patterns, { cwd: repoRoot, absolute: true });
    let migratedCount = 0;
    let skippedCount = 0;
    let errCount = 0;

    for (const filePath of files) {
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
            if (!match) {
                console.warn(`Skipping (no frontmatter): ${filePath}`);
                errCount++;
                continue;
            }

            const frontmatterText = match[0];
            let bodyText = raw.slice(frontmatterText.length);
            let changed = false;

            // 1. Rename existing loose labels safely using regex to catch "## Completion Notes"
            const completionNotesRegex = /^##\s+Completion Notes\s*$/m;
            if (completionNotesRegex.test(bodyText)) {
                bodyText = bodyText.replace(completionNotesRegex, "## Implementation Notes");
                changed = true;
            }

            // 2. Find missing headers
            const missingHeaders = REQUIRED_BODY_HEADERS.filter(
                (header) => !bodyText.includes(header)
            );

            // 3. Inject missing headers at the bottom
            if (missingHeaders.length > 0) {
                // Ensure there is at least one newline before appending
                if (!bodyText.endsWith("\n")) {
                    bodyText += "\n";
                }
                bodyText += "\n" + missingHeaders.join("\n\n") + "\n";
                changed = true;
            }

            if (changed) {
                fs.writeFileSync(filePath, frontmatterText + bodyText, "utf8");
                console.log(`Migrated: ${filePath}`);
                migratedCount++;
            } else {
                skippedCount++;
            }
        } catch (err: any) {
            console.error(`Error processing ${filePath}: ${err.message}`);
            errCount++;
        }
    }

    console.log("\nMigration Complete.");
    console.log(`Migrated: ${migratedCount}`);
    console.log(`Skipped (already valid): ${skippedCount}`);
    console.log(`Errors: ${errCount}`);
}

migrateTickets().catch((err) => {
    console.error("Fatal error during migration:", err);
    process.exit(1);
});
