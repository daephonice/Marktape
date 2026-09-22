import type { GetServerSideProps } from "next";
import type { Snapshot } from "@marktape/core";
import { getSnapshot } from "../snapshot";
import BoardTable from "../BoardTable";

type Props = { snapshot: Snapshot | null };

export default function BoardPage({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <div className="px-4 py-16 text-center text-muted">
        <p className="text-lg">PreStocks API is unreachable right now.</p>
        <p className="text-sm mt-2">No cached snapshot available yet. Try again shortly.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="px-4 pt-6 pb-2">
        <h1 className="text-2xl font-bold">The board</h1>
        <p className="text-muted text-sm">Mark vs tape, most mispriced first.</p>
      </div>
      <BoardTable initial={snapshot} />
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  try {
    const { snapshot } = await getSnapshot();
    return { props: { snapshot } };
  } catch {
    return { props: { snapshot: null } };
  }
};
