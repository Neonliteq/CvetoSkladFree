import { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  resetKey?: any;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidUpdate(prevProps: Props) {
    if (this.props.resetKey !== prevProps.resetKey) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[80vh] w-full flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardContent className="pt-6">
              <div className="flex mb-4 gap-2 items-center">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <h1 className="text-xl font-bold text-foreground">Что-то пошло не так</h1>
              </div>
              <p className="mt-4 text-sm text-muted-foreground whitespace-pre-wrap break-words border p-4 bg-muted/50 rounded-md">
                {this.state.error?.message || "Неизвестная ошибка"}
              </p>
              <div className="mt-6 flex justify-end">
                <Button 
                  onClick={() => this.setState({ hasError: false, error: undefined })}
                >
                  Попробовать снова
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
