export async function GET(req: any, res: any) {
    res.setHeader('Content-Type', 'text/plain');
    res.end(`Time: ${Date.now()}`);
}