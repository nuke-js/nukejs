export async function GET(req: any, res: any) {
    res.json([
        { username: "john", email: "john@example.com" },
        { username: "jane", email: "jane@example.com" }
    ]);
}