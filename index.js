const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const sequelize = require("./config/database");
const setupAdminPanel = require("./config/adminjs");
const { Payment, Card } = require("./models");
const { settlePaymentToSeller } = require("./controllers/payment.controller");
const { wallet } = require("./utils/blockchain");
const { Op } = require("sequelize");
const rateLimit = require('express-rate-limit');
const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 5000);
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!process.env.ADMIN_JS_TMP_DIR) {
  process.env.ADMIN_JS_TMP_DIR = path.join(__dirname, ".adminjs");
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());

// Body Parser Middleware
const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });

app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/admin")) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("ETag", undefined);
    if (req.method === "GET") res.set("Last-Modified", new Date().toUTCString());
  }

  const isAdminJsInternalRoute =
    (req.originalUrl === "/admin" || req.originalUrl.startsWith("/admin/")) &&
    !req.originalUrl.startsWith("/admin/cards/") &&
    !req.originalUrl.startsWith("/admin/refund") &&
    !req.originalUrl.startsWith("/admin/profit/") &&
    !req.originalUrl.startsWith("/admin/add-card");

  if (isAdminJsInternalRoute) return next();

  jsonParser(req, res, (err) => {
    if (err) return next(err);
    urlencodedParser(req, res, next);
  });
});


// Define a general rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, 
  legacyHeaders: false, 
  message: 'Too many requests from this IP, please try again later.',
});

app.use('/uploads', express.static(path.resolve(__dirname, 'uploads'), {
  dotfiles: 'ignore',
  index: false
}));

app.get('/admin_logo.png', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'admin_logo.png'));
});

app.use(globalLimiter);

// Routes
app.use("/auth", require("./routes/auth.routes"));
app.use("/buyer", require("./routes/buyer.routes"));
app.use("/seller", require("./routes/seller.routes"));
app.use("/admin", require("./routes/admin.routes"));
app.use("/", require("./routes/public.routes"));

// Cron Job
cron.schedule("* * * * *", async () => {
  try {
    const MAIN_BUSINESS_ACCOUNT = process.env.MAIN_BUSINESS_ACCOUNT || (wallet ? wallet.address : "");
    if (!wallet || !MAIN_BUSINESS_ACCOUNT) return;
    const now = new Date();
    const duePayments = await Payment.findAll({
      where: { status: "holding", release_at: { [Op.lte]: now } },
    });

    for (const payment of duePayments) {
      try {
        await settlePaymentToSeller({ paymentId: payment.id });
      } catch (err) {
        console.error(`Settlement failed for payment ${payment.id}:`, err.message);
      }
    }

    // Find expired pending payment intents
    const expiredPayments = await Payment.findAll({
      where: { status: "pending", expires_at: { [Op.lte]: now } },
    });

    if (expiredPayments.length > 0) {
      const expiredCardIds = expiredPayments.map(p => p.card_id).filter(Boolean);

      // Restore reserved cards back to active
      if (expiredCardIds.length > 0) {
        await Card.update(
          { status: "active" },
          { where: { id: expiredCardIds, status: "reserved" } }
        );
        console.log(`[CRON] Restored ${expiredCardIds.length} reserved card(s) to active after payment expiry.`);
      }

      // Mark expired payments
      await Payment.update(
        { status: "expired" },
        { where: { id: expiredPayments.map(p => p.id) } }
      );
      console.log(`[CRON] Marked ${expiredPayments.length} expired payment intent(s).`);
    }

    // Auto-reveal logic (24 hours after purchase/created)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const unrevealedPayments = await Payment.findAll({
      where: {
        status: { [Op.in]: ["holding", "completed", "disputed"] },
        isRevealed: false,
        autoRevealed: false,
        [Op.or]: [
          { purchasedAt: { [Op.lte]: twentyFourHoursAgo } },
          { 
            purchasedAt: null, 
            created_at: { [Op.lte]: twentyFourHoursAgo } 
          }
        ]
      }
    });

    for (const payment of unrevealedPayments) {
      try {
        payment.isRevealed = true;
        payment.revealedAt = new Date();
        payment.autoRevealed = true;
        payment.autoRevealedAt = new Date();
        payment.revealSource = "automatic";
        if (!payment.purchasedAt) {
          payment.purchasedAt = payment.created_at || new Date();
        }
        await payment.save();
        console.log(`[CRON] Auto-revealed payment #${payment.id} after 24h.`);
      } catch (err) {
        console.error(`Auto-reveal failed for payment ${payment.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Cron release task failed:", err.message);
  }
});

// Startup
async function start() {
  await sequelize.authenticate();
  try {
    await sequelize.query('ALTER TABLE payments ADD COLUMN expires_at DATETIME;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN fiat_amount REAL;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN fiat_currency VARCHAR(255);');
  } catch (e) {
    // Columns might already exist, ignore errors safely
  }
  try {
    await sequelize.query('ALTER TABLE payments ADD COLUMN isRevealed BOOLEAN DEFAULT 0;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN revealedAt DATETIME;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN autoRevealed BOOLEAN DEFAULT 0;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN autoRevealedAt DATETIME;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN purchasedAt DATETIME;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN revealSource VARCHAR(255);');
  } catch (e) {
    // Columns might already exist, ignore errors safely
  }
  try {
    await sequelize.query('ALTER TABLE users ADD COLUMN is_buyer BOOLEAN DEFAULT 0;');
    await sequelize.query('ALTER TABLE users ADD COLUMN is_seller BOOLEAN DEFAULT 0;');
  } catch (e) {
    // Columns might already exist, ignore errors safely
  }
  try {
    // Migrate existing buyer records
    await sequelize.query("UPDATE users SET is_buyer = 1 WHERE role = 'buyer';");
    // Migrate existing seller records
    await sequelize.query("UPDATE users SET is_seller = 1 WHERE role = 'seller';");
    // Migrate existing admin records to have both
    await sequelize.query("UPDATE users SET is_buyer = 1, is_seller = 1 WHERE role = 'admin';");
  } catch (e) {
    console.error("Failed to migrate user roles:", e.message);
  }
  await sequelize.sync();
  console.log("Database synced");

  // Pre-populate default platform charge setting if not present
  try {
    const { Setting } = require("./models");
    const [setting, created] = await Setting.findOrCreate({
      where: { key: "PLATFORM_CHARGE_PERCENTAGE" },
      defaults: {
        value: "10",
        description: "Platform commission charge percentage (e.g. 10 for 10%)"
      }
    });
    if (created) {
      console.log("Initialized default PLATFORM_CHARGE_PERCENTAGE setting to 10%");
    }
  } catch (err) {
    console.error("Failed to initialize PLATFORM_CHARGE_PERCENTAGE setting:", err.message);
  }

  await setupAdminPanel(app);
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
