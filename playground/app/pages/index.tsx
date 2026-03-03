import Counter from "../components/Counter"
import Nav from "../components/Nav"
import Posts from "../components/Posts"
export default async function Index() {

    return <>
        <Nav />

        <h2>Posts</h2>
        <Posts />

        <h2>Client Component</h2>
        <Counter />
    </>
}