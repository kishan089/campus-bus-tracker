// Creates (or resets the password of) a driver or admin.
//   npm run create-user -- --email ravi@example.com --name "Ravi Kumar" --role DRIVER --bus bus-1
// The password is typed at a hidden prompt (or piped in), so it never lands in your shell history.
import "dotenv/config";
import { hashPassword } from "../src/auth/password";
import { loadToolConfig } from "../src/config";
import { createPool } from "../src/db";
import { createLogger } from "../src/logger";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (!process.stdin.isTTY) { // piped input (scripts, tests)
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data.split(/\r?\n/)[0]));
      return;
    }
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") process.exit(130);                 // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const email = arg("email"), name = arg("name"), role = (arg("role") ?? "DRIVER").toUpperCase(), bus = arg("bus");
  if (!email || !name || !["DRIVER", "ADMIN"].includes(role)) {
    console.error('Usage: npm run create-user -- --email <email> --name "<full name>" --role DRIVER|ADMIN [--bus <bus-id>]');
    process.exit(1);
  }
  const password = await promptHidden("Password (min 10 characters): ");
  if (password.length < 10) { console.error("Password must be at least 10 characters."); process.exit(1); }

  const pool = createPool(loadToolConfig().databaseUrl, createLogger("warn"));
  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (role, name, email, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, role = EXCLUDED.role, active = true
       RETURNING id`, [role, name, email.toLowerCase(), hash]);
    if (bus) {
      if (role !== "DRIVER") throw new Error("--bus only applies to drivers");
      await pool.query("INSERT INTO driver_buses (driver_id, bus_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [rows[0].id, bus]);
    }
    console.log(`OK: ${role} ${email} (id ${rows[0].id})${bus ? `, assigned to ${bus}` : ""}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
