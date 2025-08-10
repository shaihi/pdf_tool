export default function handler(req, res) {
  const val = process.env.BROWSERLESS_WS_URL;
  res.status(200).json({
    hasValue: Boolean(val),
    startsWith: val ? val.substring(0, 15) + "..." : null,
    length: val ? val.length : null
  });
}