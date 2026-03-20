
import { EmailConfig, Signal, SignalType } from '../types';

const EMAILJS_URL = 'https://api.emailjs.com/api/v1.0/email/send';

export const sendEmailAlert = async (signal: Signal, config: EmailConfig): Promise<boolean> => {
  if (!config.enabled || !config.serviceId || !config.templateId || !config.publicKey || !config.targetEmail) {
    console.warn("Email alert skipped: Missing configuration");
    return false;
  }

  const templateParams = {
    to_email: config.targetEmail,
    asset: signal.asset,
    type: signal.type,
    timeframe: signal.timeFrame,
    price: signal.priceAtSignal.toString(),
    sl: signal.tradeSetup.stopLoss.toString(),
    tp: signal.tradeSetup.takeProfit.toString(),
    confidence: signal.confidence.toString(),
    reasoning: signal.reasoning.join(", "),
    timestamp: new Date(signal.timestamp).toLocaleString()
  };

  const payload = {
    service_id: config.serviceId,
    template_id: config.templateId,
    user_id: config.publicKey,
    template_params: templateParams
  };

  try {
    const response = await fetch(EMAILJS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log(`📧 Email alert sent for ${signal.asset}`);
      return true;
    } else {
      console.error("Failed to send email alert:", await response.text());
      return false;
    }
  } catch (error) {
    console.error("Error sending email alert:", error);
    return false;
  }
};
