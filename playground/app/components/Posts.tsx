import Link from "../../../src/Link"

export default async function Posts() {

    try {
        const posts = await fetch('https://nukejs.com/api/v1/posts/')
            .then(res => res.json())

        return <ul>
            {posts.forEach((post: any) => {
                <li><Link href={`/post/${post.id}`}>{post.title}</Link></li>
            })}
        </ul>
    } catch (error) {
        return <span>Oops! We couldn’t fetch the data.</span>
    }
}