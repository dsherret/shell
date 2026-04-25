const label = Deno.args[0];
for (let i = 0; i < 200; i++) {
  console.log(`[${label}] ${i.toString().padStart(2, "0")} ${Math.random().toString(36).slice(2, 10)}`);
  console.error(`hi` + i);
  await new Promise((r) => setTimeout(r, 10));
}
