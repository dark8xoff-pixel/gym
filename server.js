// BODY BUILDERS — backend
// Handles: creating Razorpay orders, verifying payments, and sending an
// automatic WhatsApp message to the gym owner on every successful payment.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// In-memory store of pending orders -> member details.
// For real use, replace with a database (even a simple JSON file or SQLite).
const pendingOrders = {};

// ---------- 1. Create a Razorpay order ----------
app.post("/create-order", async (req, res) => {
  try {
    const { amount, plan, planLabel, name, phone, email } = req.body;

    if (!amount || !name || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100, // Razorpay expects paise
      currency: "INR",
      receipt: "bb_" + Date.now(),
      notes: { plan, name, phone, email },
    });

    pendingOrders[order.id] = { plan, planLabel, name, phone, email, amount };

    res.json(order);
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: "Could not create order" });
  }
});

// ---------- 2. Verify payment + notify owner on WhatsApp ----------
app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      name,
      phone,
      email,
      plan,
      planLabel,
      amount,
    } = req.body;

    // Verify the signature Razorpay sent back — this proves the payment is real.
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: "Invalid signature" });
    }

    // Payment is genuine. Send the WhatsApp alert to the gym owner.
    await notifyOwnerOnWhatsApp({
      name,
      phone,
      email,
      planLabel: planLabel || plan,
      amount,
      paymentId: razorpay_payment_id,
    });

    delete pendingOrders[razorpay_order_id];
    res.json({ success: true });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ success: false, error: "Verification failed" });
  }
});

// ---------- WhatsApp Cloud API (Meta) helper ----------
async function notifyOwnerOnWhatsApp({ name, phone, email, planLabel, amount, paymentId }) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  // Uses an approved WhatsApp message template, since this is a business-initiated
  // message. Create a template named "membership_payment_alert" in Meta Business
  // Manager with 4 body variables, in that order: name, plan, amount, payment id.
  // See README.md for exact setup steps.
  const payload = {
    messaging_product: "whatsapp",
    to: process.env.OWNER_WHATSAPP_NUMBER, // e.g. 91XXXXXXXXXX, no + or spaces
    type: "template",
    template: {
      name: "membership_payment_alert",
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: name },
            { type: "text", text: planLabel },
            { type: "text", text: "₹" + amount },
            { type: "text", text: paymentId },
          ],
        },
      ],
    },
  };

  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`BODY BUILDERS server running on port ${PORT}`));
