import { notFound } from 'next/navigation';
import { ProjectDetail } from '@/components/projects';
import {
  getProject,
  getProjectStats,
  getProjectActivity,
  getProjectNotes,
  getProjectContracts,
} from '@/lib/projects/actions';
import { getWorkspaceCurrency } from '@/lib/settings/actions';
import { isRecordId } from '@/lib/validations/record-id';

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ProjectPageProps) {
  const { id } = await params;

  try {
    const project = await getProject(id);
    return {
      title: project.name,
    };
  } catch {
    return {
      title: 'Project Not Found',
    };
  }
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;

  // Bug #189: Validate UUID format before querying database
  if (!isRecordId(id)) {
    notFound();
  }

  // Only the data is fetched inside the try: JSX built there would not be
  // covered by it anyway, since React renders it after this function returns.
  let data: Awaited<ReturnType<typeof loadProject>>;
  try {
    data = await loadProject(id);
  } catch {
    notFound();
  }
  const [project, stats, activity, notes, contracts, currency] = data;

  return (
    <ProjectDetail
      project={project}
      stats={stats}
      activity={activity}
      notes={notes}
      contracts={contracts}
      currency={currency}
    />
  );
}

function loadProject(id: string) {
  return Promise.all([
    getProject(id),
    getProjectStats(id),
    getProjectActivity(id),
    getProjectNotes(id),
    getProjectContracts(id),
    getWorkspaceCurrency(),
  ]);
}
