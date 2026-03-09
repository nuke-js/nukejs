import Counter from "../../components/Counter"
import Nav from "../../components/Nav"
import Posts from "../../components/Posts"
export default async function Index({ s, test }: { test: string, s: string }) {

    return <>
        <Nav />
    {test}<br />
        {s}134
        <h2>Posts</h2>
        <Posts />

        <h2>Client Component</h2>
        <Counter />
    </>
}