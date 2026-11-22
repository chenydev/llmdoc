import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { TXN_DIR } from "./constants.js";
import { ensureDirectory } from "./fs.js";

interface FileBackupEntry {
  originalPath: string;
  existed: boolean;
  backupFile: string | null;
}

interface RenameEntry {
  fromPath: string;
  toPath: string;
}

/**
 * Git-free local filesystem transaction under `.llmdoc-tmp/txn/<id>/`.
 * Backs up touched files before mutating and restores them verbatim on rollback.
 */
export class LocalTransaction {
  readonly txnDir: string;
  private readonly backups: FileBackupEntry[] = [];
  private readonly backedUpPaths = new Set<string>();
  private readonly renames: RenameEntry[] = [];
  private readonly createdDirs: string[] = [];
  private backupCounter = 0;

  constructor(rootDir: string) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    this.txnDir = path.join(rootDir, TXN_DIR, id);
    fs.mkdirSync(this.txnDir, { recursive: true });
  }

  backupFile(absolutePath: string): void {
    const resolved = path.resolve(absolutePath);
    if (this.backedUpPaths.has(resolved)) {
      return;
    }
    this.backedUpPaths.add(resolved);
    if (!fs.existsSync(resolved)) {
      this.backups.push({ originalPath: resolved, existed: false, backupFile: null });
      return;
    }
    const backupFile = path.join(this.txnDir, `file-${this.backupCounter}`);
    this.backupCounter += 1;
    fs.copyFileSync(resolved, backupFile);
    this.backups.push({ originalPath: resolved, existed: true, backupFile });
  }

  ensureParentDir(targetPath: string): void {
    const parent = path.dirname(path.resolve(targetPath));
    const missing: string[] = [];
    let current = parent;
    while (!fs.existsSync(current)) {
      missing.push(current);
      const next = path.dirname(current);
      if (next === current) {
        break;
      }
      current = next;
    }
    if (missing.length > 0) {
      fs.mkdirSync(parent, { recursive: true });
      // Record deepest-first so rollback removes newly created empty dirs cleanly.
      this.createdDirs.push(...missing);
    }
  }

  movePath(fromAbsolute: string, toAbsolute: string): void {
    const fromResolved = path.resolve(fromAbsolute);
    const toResolved = path.resolve(toAbsolute);
    this.ensureParentDir(toResolved);
    try {
      fs.renameSync(fromResolved, toResolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        fs.cpSync(fromResolved, toResolved, { recursive: true });
        fs.rmSync(fromResolved, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
    this.renames.push({ fromPath: fromResolved, toPath: toResolved });
  }

  commit(): void {
    this.cleanupTxnDir();
  }

  rollback(): boolean {
    try {
      // 1. Reverse renames in LIFO order.
      for (let i = this.renames.length - 1; i >= 0; i -= 1) {
        const entry = this.renames[i]!;
        if (fs.existsSync(entry.toPath) && !fs.existsSync(entry.fromPath)) {
          ensureDirectory(entry.fromPath);
          try {
            fs.renameSync(entry.toPath, entry.fromPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EXDEV") {
              fs.cpSync(entry.toPath, entry.fromPath, { recursive: true });
              fs.rmSync(entry.toPath, { recursive: true, force: true });
            } else {
              throw error;
            }
          }
        }
      }

      // 2. Restore backed-up files verbatim (or delete files that didn't exist before).
      for (let i = this.backups.length - 1; i >= 0; i -= 1) {
        const entry = this.backups[i]!;
        if (entry.existed && entry.backupFile) {
          ensureDirectory(entry.originalPath);
          fs.copyFileSync(entry.backupFile, entry.originalPath);
        } else if (!entry.existed && fs.existsSync(entry.originalPath)) {
          fs.rmSync(entry.originalPath, { recursive: true, force: true });
        }
      }

      // 3. Remove empty directories created during this transaction.
      for (const dir of this.createdDirs) {
        try {
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
          }
        } catch {
          // ignore non-empty dir
        }
      }

      this.cleanupTxnDir();
      return true;
    } catch {
      return false;
    }
  }

  private cleanupTxnDir(): void {
    try {
      fs.rmSync(this.txnDir, { recursive: true, force: true });
      const txnRoot = path.dirname(this.txnDir);
      if (fs.existsSync(txnRoot) && fs.readdirSync(txnRoot).length === 0) {
        fs.rmdirSync(txnRoot);
      }
    } catch {
      // best effort cleanup
    }
  }
}
