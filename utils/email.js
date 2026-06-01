const nodemailer = require("nodemailer");

async function sendEmail({ to, subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    await transporter.sendMail({
      from: `"GiftCard Crypto" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    });
    
    // Fix: Pass strings as separate comma-separated arguments instead of backticks
    console.log("[EMAIL] Sent to:", to, "Subject:", subject);
  } catch (error) {
    // Fix: Treat error message completely separated from the literal format string token
    console.error("[EMAIL ERROR] Failed to send to:", to, "Error:", error.message);
    
    // Don't throw if email fails in dev, but log it
    if (process.env.NODE_ENV === 'production') throw error;
  }
}

module.exports = { sendEmail };