const { Card, Payment, Setting } = require("../models");
const { parseAmount } = require("../utils/helpers");
const { Op } = require("sequelize");
const fs = require("fs");
const path = require("path");

exports.getCards = async (req, res) => {
  if (req.user.role !== "seller")
    return res.status(403).json({ error: "Access denied" });
  try {
    const cards = await Card.findAll({
      where: { seller_id: req.user.id },
      include: [{ model: Payment, as: "payment" }],
      order: [["id", "DESC"]],
    });
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.cancelCard = async (req, res) => {
  if (req.user?.role !== "seller") {
    return res.status(403).json({ error: "Access denied. Only sellers can cancel listings." });
  }

  try {
    const cardId = Number(req.params.id);
    const sellerId = Number(req.user.id);

    const card = await Card.findByPk(cardId);
    if (!card) return res.status(404).json({ error: `Card #${cardId} not found.` });

    if (Number(card.seller_id) !== sellerId) {
      return res.status(403).json({ error: "Permission denied. You are not the owner of this card." });
    }

    if (card.status === "cancelled") return res.json({ message: "Card is already cancelled." });

    if (card.status !== "active") {
      return res.status(400).json({ error: `Cannot cancel this card because it is already '${card.status}'.` });
    }

    const existingPayment = await Payment.findOne({
      where: { card_id: card.id, status: { [Op.in]: ["pending", "holding"] } },
    });

    if (existingPayment) {
      return res.status(400).json({ error: `Cannot cancel card while a buyer is processing a payment.` });
    }

    card.status = "cancelled";
    await card.save();

    res.json({ message: "Card listing cancelled successfully." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const { retailerValidation } = require("../utils/retailerConfig");

exports.sellCard = async (req, res) => {
  try {
    if (req.user.role !== "seller") return res.status(403).json({ error: "Access denied" });
    const { retailer, price, card_code, card_pin, seller_wallet_address, region, currency } = req.body;
    const amount = parseAmount(price);

    if (!retailer || !amount || !card_code || !seller_wallet_address) {
     if (req.file?.filename) {
        // Construct a safe absolute or relative path using only the safe filename
        const safePath = path.join(__dirname, "../uploads", path.basename(req.file.filename));
        fs.unlink(safePath, () => undefined);
      }
      return res.status(400).json({ error: "retailer, price, card_code and seller_wallet_address are required." });
    }

    // Validation Logic
    const configKey = region === "UK" ? (retailer === "Uber" ? "Uber_UK" : (retailer === "PlayStation" ? "PlayStation_UK" : retailer)) : (region === "Canada" && retailer === "Amazon" ? "Amazon_CA" : retailer);
    const config = retailerValidation[configKey];

    let isValid = true;
    let validationStatus = "VALID";
    let status = "pending_approval";

    if (config) {
      // Validate digits (supporting single value or array of values)
      const digitsArray = Array.isArray(config.digits) ? config.digits : [config.digits];
      if (!digitsArray.includes(card_code.length)) {
        isValid = false;
        validationStatus = "INVALID";
        status = "invalid";
      }

      // Validate prefix (case-insensitive)
      if (config.startsWith.length > 0) {
        const upperCode = card_code.toUpperCase();
        const matchesPrefix = config.startsWith.some(prefix => upperCode.startsWith(prefix.toUpperCase()));
        if (!matchesPrefix) {
          const isStrict = config.strictPrefix !== false;
          if (isStrict) {
            isValid = false;
            validationStatus = "INVALID";
            status = "invalid";
          }
        }
      }

      // Validate PIN
      if (config.pinRequired && !card_pin) {
        isValid = false;
        validationStatus = "INVALID";
        status = "invalid";
      }
    }

    // Pricing Logic
    const sellerRate = config ? config.sellerRate : 0.75;
    const buyerRate = config ? config.buyerRate : 0.85;

    // Fetch default platform charge from settings
    const chargeSetting = await Setting.findOne({ where: { key: "PLATFORM_CHARGE_PERCENTAGE" } });
    const platformChargePercentage = chargeSetting ? parseFloat(chargeSetting.value) : 10;

    const buyerPays = amount * buyerRate;
    const platformProfit = amount * (platformChargePercentage / 100);
    const sellerReceives = buyerPays - platformProfit;

    const card = await Card.create({
      name: `${retailer} Gift Card`,
      description: `Gift card for ${retailer} (${region})`,
      price: buyerPays, // The price the buyer actually pays
      seller_asking_price: amount, // The face value of the card
      denomination: amount,
      file_path: req.file ? path.join("uploads", path.basename(req.file.filename)) : "",
      status: status,
      retailer,
      card_code,
      card_pin,
      seller_wallet_address,
      region: region || "USA",
      currency: currency || "USD",
      seller_id: req.user.id,
      isValid: isValid,
      validationStatus: validationStatus,
      sellerReceives: sellerReceives,
      buyerPays: buyerPays,
      platformProfit: platformProfit,
      platformChargePercentage: platformChargePercentage,
    });

    return res.status(201).json({ 
      message: isValid ? "Card listed successfully." : "Card listing failed validation.", 
      card_id: card.id,
      isValid,
      sellerReceives
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
