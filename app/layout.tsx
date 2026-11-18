export const metadata = {
  title: { default: "Living Well Split", template: "%s · Living Well Split" },
  description: "In-house CRO split testing for a Shopify store",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", color: "#29404E", background: "#fff" }}>
        {children}
      </body>
    </html>
  );
}
