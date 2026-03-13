export const metadata = {
  title: "WhatsApp Coexistence Demo",
  description: "WhatsApp Business App + Cloud API coexistence with Vercel Chat SDK",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem", maxWidth: "800px", marginInline: "auto" }}>
        {children}
      </body>
    </html>
  );
}
