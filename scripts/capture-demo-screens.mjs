import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../docs/demo");
const base = "http://localhost:3000";

async function goto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1500);
}

async function login(page, email, password) {
  await goto(page, `${base}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/home**", { timeout: 45000 });
  await page.waitForTimeout(1500);
}

async function shot(page, name) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", name);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await goto(page, base);
  await shot(page, "01-landing.png");

  await goto(page, `${base}/login`);
  await shot(page, "02-login.png");

  await login(page, "teacher@englishhub.vn", "Password123!");
  await shot(page, "03-teacher-dashboard.png");

  await goto(page, `${base}/home?tab=classrooms`);
  await page.waitForSelector(".home-rail, .home-class-card, .empty-state", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await shot(page, "04-teacher-classrooms.png");

  const bell = page.locator('button[aria-label="Thông báo"]');
  if (await bell.count()) {
    await bell.click();
    await page.waitForTimeout(800);
  }
  await shot(page, "05-notifications.png");

  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await login(page, "student@englishhub.vn", "Password123!");
  await shot(page, "06-student-dashboard.png");

  await goto(page, `${base}/home?tab=classrooms`);
  await page.waitForSelector(".home-rail, .home-class-card, .empty-state", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await shot(page, "07-student-classrooms.png");

  await goto(page, `${base}/home?tab=mascot`);
  await page.waitForTimeout(1200);
  await shot(page, "08-ai-tutor.png");

  await goto(page, `${base}/home?tab=account`);
  await page.waitForTimeout(1000);
  await shot(page, "09-account.png");

  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await login(page, "teacher@englishhub.vn", "Password123!");
  await goto(page, `${base}/home?tab=classrooms`);
  await page.waitForTimeout(1500);
  const openClass = page.locator('a[href*="/teacher/classrooms/"]').first();
  if (await openClass.count()) {
    await openClass.click();
    await page.waitForTimeout(2000);
    await shot(page, "10-teacher-quizzes.png");
  } else {
    console.log("skip 10-teacher-quizzes (no classroom link)");
  }

  // Student exam page if a published quiz link exists
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await login(page, "student@englishhub.vn", "Password123!");
  await goto(page, `${base}/home?tab=classrooms`);
  await page.waitForTimeout(1500);
  const studentClass = page.locator('a[href*="/student/classrooms/"]').first();
  if (await studentClass.count()) {
    await studentClass.click();
    await page.waitForTimeout(2000);
    await shot(page, "11-student-classroom.png");
    const quizLink = page.locator('a[href*="/quizzes/"]').first();
    if (await quizLink.count()) {
      await quizLink.click();
      await page.waitForTimeout(2000);
      await shot(page, "12-student-exam.png");
    } else {
      console.log("skip 12-student-exam (no quiz link)");
    }
  } else {
    console.log("skip 11-student-classroom (no classroom link)");
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
