const { Card, Payment, PlatformProfit, User } = require("../models");
const { parseAmount } = require("../utils/helpers");
const { refundPaymentByLookup } = require("./payment.controller");
const { transferFunds } = require("../utils/blockchain");
const fs = require("fs");
const path = require("path");
exports.approveCard = async (req, res) => {
  try {
    const card = await Card.findByPk(req.params.id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (card.status !== "pending_approval") {
      return res.status(400).json({ error: "Card is not pending approval" });
    }
    card.status = "active";
    await card.save();
    res.json({ message: "Card approved and now active", card });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.rejectCard = async (req, res) => {
  try {
    const card = await Card.findByPk(req.params.id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (card.status !== "pending_approval") {
      return res.status(400).json({ error: "Card is not pending approval" });
    }
    card.status = "rejected";
    await card.save();
    res.json({ message: "Card rejected", card });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.addCard = async (req, res) => {
  try {
    const { name, description = "", price } = req.body;
    const amount = parseAmount(price);

    if (!name || !amount || !req.file) {
      if (req.file && req.file.path) {
        // Resolve the local absolute path and apply a folder guard
        const resolvedPath = path.resolve(req.file.path);
        const allowedDirectory = path.resolve(__dirname, "../uploads");

        if (resolvedPath.startsWith(allowedDirectory)) {
          fs.unlink(resolvedPath, () => undefined);
        }
      }
      return res.status(400).json({ error: "name, price and file are required." });
    }

    const safeFilename = path.basename(req.file.filename || req.file.path);
    const secureDatabasePath = path.join("uploads", safeFilename);

    const card = await Card.create({
      name: name.trim(),
      description: description.trim(),
      price: amount,
      file_path: secureDatabasePath,
      status: "active",
    });

    return res.status(201).json({ message: "Card added successfully.", card_id: card.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.refundPayment = async (req, res) => {
  try {
    const body = req.body || {};
    const txHash = String(body.tx_hash || body.external_id || "").trim();
    const paymentId = body.payment_id ? Number(body.payment_id) : null;

    const { payment, refundTxHash } = await refundPaymentByLookup({
      txHash: txHash || null,
      paymentId,
    });

    return res.json({
      message: "Refund executed.",
      payment_id: payment.id,
      refund_tx_hash: refundTxHash,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.getProfitSummary = async (req, res) => {
  try {
    const totalProfit = await PlatformProfit.sum("admin_profit") || 0;
    const holdingProfit = (await PlatformProfit.sum("admin_profit", { where: { status: "holding" } })) || 0;
    const releasedProfit = (await PlatformProfit.sum("admin_profit", { where: { status: "released" } })) || 0;
    const withdrawnProfit = (await PlatformProfit.sum("admin_profit", { where: { status: "withdrawn" } })) || 0;

    const totalTransactions = await PlatformProfit.count();
    const totalSellerPayouts = await PlatformProfit.sum("seller_payout") || 0;
    const totalBuyerPayments = await PlatformProfit.sum("total_amount") || 0;

    res.json({
      summary: {
        total_profit: Number(totalProfit).toFixed(6),
        total_seller_payouts: Number(totalSellerPayouts).toFixed(6),
        total_buyer_payments: Number(totalBuyerPayments).toFixed(6),
        total_transactions: totalTransactions,
      },
      profit_breakdown: {
        holding: Number(holdingProfit).toFixed(6),
        released: Number(releasedProfit).toFixed(6),
        withdrawn: Number(withdrawnProfit).toFixed(6),
      },
      available_to_withdraw: Number(releasedProfit).toFixed(6),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getProfitDetails = async (req, res) => {
  try {
    const status = req.query.status || "holding";
    const profits = await PlatformProfit.findAll({
      where: { status },
      include: [
        { model: Card, as: "card", attributes: ["id", "name", "price"] },
        { model: User, as: "seller", attributes: ["id", "email", "role"] },
      ],
      order: [["created_at", "DESC"]],
    });

    res.json({
      status,
      count: profits.length,
      total_profit: Number(profits.reduce((sum, p) => sum + (p.admin_profit || 0), 0)).toFixed(6),
      records: profits,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.withdrawProfit = async (req, res) => {
  try {
    const { amount, address } = req.body;
    if (!amount || !address) return res.status(400).json({ error: "Amount and address required" });

    const releasedProfit = (await PlatformProfit.sum("admin_profit", { where: { status: "released" } })) || 0;
    if (Number(amount) > releasedProfit) {
      return res.status(400).json({
        error: "Insufficient released profit to withdraw",
        available: Number(releasedProfit).toFixed(6),
        requested: amount,
      });
    }

    const withdrawTxHash = await transferFunds({ to: address, amount: Number(amount), asset: "ETH", decimals: 18 });

    let remainingAmount = Number(amount);
    const profitsToWithdraw = await PlatformProfit.findAll({ where: { status: "released" }, order: [["created_at", "ASC"]] });

    for (const profit of profitsToWithdraw) {
      if (remainingAmount <= 0) break;
      const withdrawAmount = Math.min(remainingAmount, profit.admin_profit);
      profit.status = "withdrawn";
      profit.withdrawn_at = new Date();
      profit.withdraw_tx_hash = withdrawTxHash;
      await profit.save();
      remainingAmount -= withdrawAmount;
    }

    res.json({ message: "Profit withdrawn successfully", amount: amount, tx_hash: withdrawTxHash, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
